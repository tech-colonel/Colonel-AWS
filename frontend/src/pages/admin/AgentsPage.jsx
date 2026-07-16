import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { channelLogoSrc } from '../../components/ChannelLogo';
import { Building2, Bot, Plus, TrendingUp, ChevronRight, Activity, FileSpreadsheet, Target, Layers, PieChart as PieIcon } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import { ResponsiveContainer, AreaChart, Area, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import api from '../../lib/api';
import { toast } from 'sonner';
import { ADMIN_SIDEBAR } from '../../lib/adminNav';
import ToolDetails from './ToolDetails';

const nfmt = (n) => (n ?? 0).toLocaleString('en-IN');
const fmtDate = (s) => { try { return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }); } catch { return '—'; } };

const sidebarItems = ADMIN_SIDEBAR;

// Rich metadata for the RECO + MTR + Bank agents (matched by DB `name`).
// `section` decides which category bucket the card lands in.
const RICH_META = {
  gstr_2b_books:            { section: 'reco',        displayName: 'GSTR-2B vs Books',               icon: '📂', category: 'GST Reconciliation', color: '#0748EE', bg: '#E8EFFE', border: '#A3BFF8', accuracy: '99.5%' },
  gstr_2b_books_multistate: { section: 'reco',        displayName: 'GSTR-2B vs Books (Multi-State)', icon: '🗺️', category: 'GST Reconciliation', color: '#7C3AED', bg: '#F5F3FF', border: '#C4B5FD', accuracy: '99.5%' },
  gstr_1_vs_books:          { section: 'reco',        displayName: 'GSTR-1 vs Books',                icon: '📊', category: 'GST Reconciliation', color: '#0748EE', bg: '#E8EFFE', border: '#A3BFF8', accuracy: '99.3%' },
  einvoice_reco:            { section: 'reco',        displayName: 'E-Invoice Reco',                 icon: '🧾', category: 'GST Reconciliation', color: '#0284C7', bg: '#F0F9FF', border: '#BAE6FD', accuracy: '99.6%' },
  gstr_3b_tally_entry:      { section: 'reco',        displayName: 'GSTR-3B Tally Entry',            icon: '📒', category: 'Journal Entry',      color: '#0F766E', bg: '#F0FDFA', border: '#99F6E4', accuracy: '99.9%' },
  universal_bank_statement: { section: 'bank',        displayName: 'Universal Bank Statement',       icon: '🌍', category: 'Bank & Finance',     color: '#059669', bg: '#ECFDF5', border: '#A7F3D0', accuracy: '100%'  },
  amazon_mtr_consolidator:  { section: 'marketplace', displayName: 'Amazon MTR Consolidator',        icon: '🛒', category: 'Marketplace MIS',    color: '#D97706', bg: '#FFFBEB', border: '#FDE68A', accuracy: '99.8%' },
  pdf_bank_extract:         { section: 'bank',        displayName: 'PDF → Bank Statement',           icon: '📄', category: 'Bank & Finance',     color: '#0748EE', bg: '#E8EFFE', border: '#A3BFF8', accuracy: 'Auto-detect' },
};

// Category sections, in display order.
const SECTIONS = [
  { key: 'reco',        label: 'GST Reconciliation', accent: '#0748EE' },
  { key: 'bank',        label: 'Bank & Finance',     accent: '#059669' },
  { key: 'invoice',     label: 'Invoice',            accent: '#7C3AED' },
  { key: 'marketplace', label: 'Marketplace MIS',    accent: '#D97706' },
  { key: 'other',       label: 'Other',              accent: '#64748B' },
];

// Decide a section for any agent: rich meta wins, else infer from the name.
const sectionOf = (agent) => {
  if (RICH_META[agent.name]) return RICH_META[agent.name].section;
  const n = (agent.name || '').toLowerCase();
  if (/invoice/.test(n)) return 'invoice';
  if (/bank/.test(n)) return 'bank';
  if (/gstr|reco|tally|2b|3b/.test(n)) return 'reco';
  if (/amazon|flipkart|meesho|myntra|nykaa|ajio|jiomart|firstcry|shopify|blinkit|zepto|seller|marketplace|mtr/.test(n)) return 'marketplace';
  return 'other';
};

// Per-section styling for agents without rich meta (mirrors the accountant inventory).
const SECTION_STYLE = {
  reco:        { category: 'GST Reconciliation', color: '#0748EE', bg: '#E8EFFE', border: '#A3BFF8' },
  bank:        { category: 'Bank & Finance',     color: '#059669', bg: '#ECFDF5', border: '#A7F3D0' },
  invoice:     { category: 'Invoice',            color: '#7C3AED', bg: '#F5F3FF', border: '#C4B5FD' },
  marketplace: { category: 'Marketplace MIS',    color: '#D97706', bg: '#FFFBEB', border: '#FDE68A' },
  other:       { category: 'Other',              color: '#64748B', bg: '#F1F5F9', border: '#CBD5E1' },
};
const CHANNEL_ICON = {
  amazon: '🛒', flipkart: '🛍️', myntra: '👗', nykaa: '💄', zepto: '⚡', blinkit: '🛒',
  jiomart: '🏬', firstcry: '🧸', shopify: '🛍️', mirrow: '🪞', cread: '📦', limeroad: '👜',
  settlement: '💰', total: '📊', meesho: '🏷️', ajio: '👕',
};
const channelIcon = (name) => {
  const n = (name || '').toLowerCase();
  for (const k in CHANNEL_ICON) if (n.includes(k)) return CHANNEL_ICON[k];
  return '🛍️';
};
// Brand-colored monogram tiles per marketplace (brand color + short label — NOT logo artwork).
const CHANNEL_BRAND = {
  settlement: { bg: '#FF9900', fg: '#1A1A1A', label: 'A$' },
  total:      { bg: '#0748EE', fg: '#FFFFFF', label: 'TS' },
  amazon:     { bg: '#FF9900', fg: '#1A1A1A', label: 'a' },
  flipkart:   { bg: '#2874F0', fg: '#FFFFFF', label: 'F' },
  myntra:     { bg: '#FF3F6C', fg: '#FFFFFF', label: 'M' },
  nykaa:      { bg: '#E80071', fg: '#FFFFFF', label: 'N' },
  zepto:      { bg: '#6C2BD9', fg: '#FFFFFF', label: 'Z' },
  blinkit:    { bg: '#F8CB46', fg: '#1A1A1A', label: 'b' },
  jiomart:    { bg: '#0C51A1', fg: '#FFFFFF', label: 'J' },
  firstcry:   { bg: '#F7941D', fg: '#FFFFFF', label: 'FC' },
  shopify:    { bg: '#95BF47', fg: '#FFFFFF', label: 'S' },
  meesho:     { bg: '#F43397', fg: '#FFFFFF', label: 'Me' },
  ajio:       { bg: '#2C4152', fg: '#FFFFFF', label: 'AJ' },
  limeroad:   { bg: '#8CC63F', fg: '#1A1A1A', label: 'LR' },
  mirrow:     { bg: '#334155', fg: '#FFFFFF', label: 'Mi' },
  cread:      { bg: '#475569', fg: '#FFFFFF', label: 'Cr' },
};
const channelBrand = (name) => {
  const n = (name || '').toLowerCase();
  for (const k in CHANNEL_BRAND) if (n.includes(k)) return CHANNEL_BRAND[k];
  return null;
};

// ── Rich card (RECO + MTR + Bank) ───────────────────────────────────────────
const RichAgentCard = ({ meta, description, onClick }) => (
  <button onClick={onClick}
    className="text-left w-full rounded-2xl border bg-white p-5 transition-shadow hover:shadow-md group"
    style={{ borderColor: '#E2E8F0' }}>
    <div className="flex items-start justify-between mb-3">
      <div className="w-11 h-11 rounded-xl flex items-center justify-center text-xl flex-shrink-0"
        style={{ background: meta.bg, border: `1px solid ${meta.border}` }}>
        {meta.icon}
      </div>
      <span className="flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full"
        style={{ background: meta.bg, color: meta.color, border: `1px solid ${meta.border}` }}>
        <TrendingUp className="w-2.5 h-2.5" /> {meta.accuracy}
      </span>
    </div>
    <h3 className="text-sm font-bold mb-1.5 text-slate-900">{meta.displayName}</h3>
    <p className="text-xs leading-relaxed mb-4 text-slate-500 line-clamp-3">{description}</p>
    <div className="flex items-center justify-between">
      <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
        style={{ background: meta.bg, color: meta.color, border: `1px solid ${meta.border}` }}>
        {meta.category}
      </span>
      <span className="flex items-center gap-1 text-xs font-semibold transition-all group-hover:gap-1.5" style={{ color: meta.color }}>
        Open <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
      </span>
    </div>
  </button>
);

// ── Colorful card (marketplace / invoice / other) — matches the accountant inventory ──
const SimpleAgentCard = ({ agent, onClick }) => {
  const s = SECTION_STYLE[sectionOf(agent)] || SECTION_STYLE.other;
  const mono = channelBrand(agent.name);
  const logoSrc = channelLogoSrc(agent.name);
  return (
    <button onClick={onClick}
      className="text-left w-full rounded-2xl border bg-white transition-all duration-200 flex flex-col overflow-hidden hover:shadow-lg hover:-translate-y-0.5 group"
      style={{ borderColor: s.border }}>
      <div className="p-5 flex-1">
        <div className="flex items-start justify-between mb-3">
          {logoSrc ? (
            <div className="w-11 h-11 rounded-xl flex items-center justify-center bg-white border overflow-hidden"
              style={{ borderColor: s.border, padding: 6 }}>
              <img src={logoSrc} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
            </div>
          ) : mono ? (
            <div className="w-11 h-11 rounded-xl flex items-center justify-center font-extrabold text-base tracking-tight"
              style={{ background: mono.bg, color: mono.fg }}>{mono.label}</div>
          ) : (
            <div className="w-11 h-11 rounded-xl flex items-center justify-center text-2xl"
              style={{ background: s.bg, border: `1.5px solid ${s.border}` }}>{channelIcon(agent.name)}</div>
          )}
        </div>
        <h3 className="font-bold text-slate-900 text-base mb-1 leading-snug">{agent.name}</h3>
        <p className="text-slate-500 text-xs leading-relaxed line-clamp-2">{agent.description || 'Marketplace / data agent'}</p>
      </div>
      <div className="px-5 py-3 flex items-center justify-between border-t"
        style={{ borderColor: s.border, background: s.bg }}>
        <span className="text-xs font-bold uppercase tracking-wide" style={{ color: s.color }}>{s.category}</span>
        <span className="flex items-center gap-1 text-xs font-semibold transition-all group-hover:gap-1.5" style={{ color: s.color }}>
          Open <ChevronRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
        </span>
      </div>
    </button>
  );
};

// Myntra Ticket Finder — distinctive cream / monospace card (D'Chica ops-hub style).
const MyntraCard = ({ onClick }) => (
  <div
    onClick={onClick}
    data-testid="agent-card-myntra"
    style={{
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      background: '#FAF7EC', border: '2px solid #1A1A1A', boxShadow: '6px 6px 0 rgba(26,26,26,0.9)',
      borderRadius: 4, padding: '20px 22px', display: 'flex', flexDirection: 'column', cursor: 'pointer',
      transition: 'transform .15s ease, box-shadow .15s ease',
    }}
    onMouseEnter={e => { e.currentTarget.style.transform = 'translate(-2px,-2px)'; e.currentTarget.style.boxShadow = '8px 8px 0 rgba(26,26,26,0.9)'; }}
    onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '6px 6px 0 rgba(26,26,26,0.9)'; }}
  >
    <div style={{ fontSize: 11, letterSpacing: '0.12em', color: '#9B2242', fontWeight: 700, textTransform: 'uppercase', marginBottom: 10 }}>
      Marketplace · Myntra
    </div>
    <h3 style={{ fontSize: 20, fontWeight: 800, color: '#1A1A1A', letterSpacing: '0.02em', margin: '0 0 12px', lineHeight: 1.15 }}>
      MYNTRA TICKET <span style={{ color: '#9B2242' }}>FINDER</span>
    </h3>
    <span style={{ alignSelf: 'flex-start', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', background: '#F3D9E0', color: '#8B1E3F', padding: '4px 9px', borderRadius: 3, marginBottom: 12 }}>
      Marketplace Team
    </span>
    <p style={{ fontSize: 12.5, color: '#555', lineHeight: 1.65, margin: '0 0 16px', flex: 1 }}>
      Upload Myntra Seller Hub reports to automatically detect billing errors — commission not reversed,
      closed-box return claims, fixed fee retention, commission rate overcharges. Generates proof files
      and ticket templates ready to paste into Myntra Seller Support.
    </p>
    <div style={{ borderTop: '1px solid #D8D2BE', paddingTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#7A7458', fontWeight: 600 }}>
        Run after each settlement cycle
      </span>
      <span style={{ fontSize: 16, color: '#1A1A1A' }}>→</span>
    </div>
  </div>
);

// ── Analysis tab: platform-wide tool analytics ──────────────────────────────
// Donut palette for runs-share (per tool). Stable cycle, fintech-muted.
const DONUT_CYCLE = ['#0748EE', '#7C3AED', '#0F766E', '#D97706', '#E11D48', '#059669', '#2563EB', '#DB2777', '#0891B2', '#CA8A04', '#94A3B8'];

const StatCard = ({ icon: Icon, label, value, sub, color, bg }) => (
  <div className="stat-card" style={{ padding: '16px 18px', background: bg, border: `1px solid ${color}22` }}>
    <div className="flex items-center gap-2.5 mb-2">
      <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: '#FFFFFF', border: `1px solid ${color}33` }}>
        <Icon className="w-4 h-4" style={{ color }} />
      </div>
      <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color, opacity: 0.85 }}>{label}</span>
    </div>
    <div style={{ fontFamily: 'Barlow, sans-serif', fontWeight: 900, fontSize: '28px', lineHeight: 1.05, color }}>{value}</div>
    {sub && <div className="text-xs font-medium mt-1" style={{ color, opacity: 0.7 }}>{sub}</div>}
  </div>
);

const ToolAnalysis = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null); // { agentType, label } | null

  useEffect(() => {
    api.get('/api/dashboard/admin/tool-analytics')
      .then(r => setData(r.data))
      .catch(() => toast.error('Failed to load analytics'))
      .finally(() => setLoading(false));
  }, []);

  // Drill-down takes over the whole panel.
  if (selected) {
    return <ToolDetails agentType={selected.agentType} label={selected.label} onClose={() => setSelected(null)} />;
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">{[1,2,3,4,5].map(i => <div key={i} className="h-24 rounded-2xl bg-slate-100 animate-pulse" />)}</div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">{[1,2].map(i => <div key={i} className={`${i === 1 ? 'lg:col-span-2' : ''} h-64 rounded-2xl bg-slate-100 animate-pulse`} />)}</div>
      </div>
    );
  }

  const t = data?.totals || {};
  const tools = data?.tools || [];
  const timeline = data?.timeline || [];
  const runsShare = data?.runsShare || [];

  const timelineHasRuns = timeline.some(d => Number(d.runs) > 0);
  const matchColor = (r) => (r == null ? '#94A3B8' : r >= 80 ? '#059669' : r >= 50 ? '#D97706' : '#E11D48');

  return (
    <div className="space-y-6">
      {/* Header stat row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <StatCard icon={Layers}          label="Active Tools"   value={`${nfmt(t.activeTools)} / ${nfmt(t.totalTools)}`} sub="tools with runs" color="#0748EE" bg="#E8EFFE" />
        <StatCard icon={Activity}        label="Total Runs"     value={nfmt(t.runs)} color="#7C3AED" bg="#F5F3FF" />
        <StatCard icon={FileSpreadsheet} label="Rows Processed" value={nfmt(t.rows)} color="#0F766E" bg="#ECFEFF" />
        <StatCard icon={Building2}       label="Brands"         value={`${nfmt(t.brandsWithData)} / ${nfmt(t.brands)}`} sub="with data" color="#D97706" bg="#FFFBEB" />
        <StatCard icon={Target}          label="Match Rate"     value={t.matchRate != null ? `${t.matchRate}%` : '—'} color="#059669" bg="#ECFDF5" />
      </div>

      {/* Timeline (2/3) + Donut (1/3) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="glass-card lg:col-span-2" style={{ padding: '16px 18px' }}>
          <div className="mb-3">
            <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748B' }}>Activity · last 30 days</div>
            <div className="text-xs text-slate-400 mt-0.5">Daily runs across every tool</div>
          </div>
          {timelineHasRuns ? (
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={timeline} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <defs><linearGradient id="runsG" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#0748EE" stopOpacity={0.22} /><stop offset="100%" stopColor="#0748EE" stopOpacity={0} /></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
                <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fontSize: 11, fill: '#94A3B8' }} minTickGap={24} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94A3B8' }} />
                <Tooltip labelFormatter={fmtDate} formatter={(v) => [nfmt(v), 'Runs']} />
                <Area type="monotone" dataKey="runs" stroke="#0748EE" fill="url(#runsG)" strokeWidth={2.5} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex flex-col items-center justify-center text-center" style={{ height: 240 }}>
              <div className="w-10 h-10 rounded-full flex items-center justify-center mb-2" style={{ background: '#F1F5F9' }}>
                <Activity className="w-4 h-4 text-slate-300" />
              </div>
              <span className="text-sm text-slate-400">No runs in the last 30 days</span>
            </div>
          )}
        </div>

        <div className="glass-card" style={{ padding: '16px 18px' }}>
          <div className="mb-3">
            <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748B' }}>Runs share</div>
            <div className="text-xs text-slate-400 mt-0.5">Distribution by tool</div>
          </div>
          {runsShare.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={runsShare} dataKey="runs" nameKey="name" innerRadius={55} outerRadius={80} paddingAngle={2}>
                  {runsShare.map((d, i) => <Cell key={d.agent_type || d.name} fill={DONUT_CYCLE[i % DONUT_CYCLE.length]} />)}
                </Pie>
                <Tooltip formatter={(v, n) => [nfmt(v), n]} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex flex-col items-center justify-center text-center" style={{ height: 240 }}>
              <div className="w-10 h-10 rounded-full flex items-center justify-center mb-2" style={{ background: '#F1F5F9' }}>
                <PieIcon className="w-4 h-4 text-slate-300" />
              </div>
              <span className="text-sm text-slate-400">No runs yet</span>
              <span className="text-xs text-slate-300 mt-0.5">Run a tool to see its share</span>
            </div>
          )}
        </div>
      </div>

      {/* Per-tool table (ALL tools, clickable) */}
      <div className="glass-card overflow-hidden">
        <div className="px-5 py-3 text-xs font-bold uppercase tracking-wide text-slate-500 border-b" style={{ borderColor: '#E2E8F0' }}>
          Per-tool breakdown <span className="font-normal normal-case text-slate-400">· {nfmt(t.totalTools)} tools · {nfmt(t.activeTools)} active · across {nfmt(t.brands)} brands</span>
        </div>
        {tools.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-slate-400">No tools registered yet</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ minWidth: '640px' }}>
              <thead>
                <tr className="text-left text-xs text-slate-500" style={{ borderBottom: '1px solid #E2E8F0' }}>
                  <th className="px-5 py-2.5 font-semibold">Tool</th>
                  <th className="px-5 py-2.5 font-semibold text-right">Runs</th>
                  <th className="px-5 py-2.5 font-semibold text-right">Rows</th>
                  <th className="px-5 py-2.5 font-semibold text-right">Match&nbsp;%</th>
                  <th className="px-5 py-2.5 font-semibold text-right">Last&nbsp;run</th>
                  <th className="px-5 py-2.5 font-semibold text-right" style={{ width: '40px' }}></th>
                </tr>
              </thead>
              <tbody>
                {tools.map((x) => {
                  const inactive = !x.runs;
                  return (
                    <tr key={x.agent_type}
                      onClick={() => setSelected({ agentType: x.agent_type, label: x.label })}
                      className="border-b last:border-0 cursor-pointer transition-colors hover:bg-slate-50 group"
                      style={{ borderColor: '#F1F5F9', opacity: inactive ? 0.55 : 1 }}>
                      <td className="px-5 py-2.5 font-medium" style={{ color: inactive ? '#94A3B8' : '#1E293B' }}>{x.label}</td>
                      <td className="px-5 py-2.5 text-right text-slate-700" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{nfmt(x.runs)}</td>
                      <td className="px-5 py-2.5 text-right text-slate-700" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{nfmt(x.rows)}</td>
                      <td className="px-5 py-2.5 text-right">
                        {x.matchRate != null
                          ? <span className="font-semibold" style={{ color: matchColor(x.matchRate) }}>{x.matchRate}%</span>
                          : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-5 py-2.5 text-right text-slate-500">{x.lastRun ? fmtDate(x.lastRun) : '—'}</td>
                      <td className="px-5 py-2.5 text-right">
                        <ChevronRight className="w-4 h-4 inline text-slate-300 group-hover:text-[#0748EE] transition-colors" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

const AgentsPage = () => {
  const navigate = useNavigate();
  const [tab, setTab] = useState('agents');
  const [agents, setAgents] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [formData, setFormData] = useState({ name: '', description: '', useBasicColumns: true });

  useEffect(() => { fetchAgents(); }, []);

  // Admin opens an agent against the "Other" sandbox brand (real DB: colonel_other).
  // Runs save there so the analytics page works just like for a user — and the data
  // is wiped on Reset or by the nightly purge cron (colonel_other is in its scope).
  const SANDBOX_BRAND_ID = '09abc16b-643a-4380-a716-8a69e3435511';
  const openAgent = (agent) => navigate(`/brands/${SANDBOX_BRAND_ID}/agents/${agent.id}`);

  const fetchAgents = async () => {
    try {
      const response = await api.get('/api/agents');
      setAgents(response.data);
    } catch (error) {
      toast.error('Failed to load agents');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const basicColumns = [
        { name: 'id', type: 'UUID', primaryKey: true, defaultValue: 'UUIDV4' },
        { name: 'month', type: 'INTEGER' },
        { name: 'year', type: 'INTEGER' },
        { name: 'inventory_type', type: 'STRING' },
        { name: 'filename', type: 'STRING' },
        { name: 'created_at', type: 'DATE', defaultValue: 'NOW' },
        { name: 'date', type: 'DATE' }
      ];
      const defaultColumns = [
        { name: 'SKU', type: 'STRING' },
        { name: 'Product_Name', type: 'STRING' },
        { name: 'Quantity', type: 'INTEGER' },
        { name: 'Amount', type: 'DECIMAL' },
        { name: 'State', type: 'STRING' }
      ];
      const payload = {
        name: formData.name,
        description: formData.description,
        columns: formData.useBasicColumns ? basicColumns : defaultColumns
      };
      await api.post('/api/agents', payload);
      toast.success('Agent created successfully');
      setShowModal(false);
      setFormData({ name: '', description: '', useBasicColumns: true });
      fetchAgents();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to create agent');
    }
  };

  const bySection = SECTIONS.map(s => ({
    ...s,
    items: agents.filter(a => sectionOf(a) === s.key),
  })).filter(s => s.items.length > 0);

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6" data-testid="agents-page">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Agents</h1>
            <p className="text-slate-600 mt-1">{agents.length} agents available across the platform</p>
          </div>
          {tab === 'agents' && (
            <Button onClick={() => setShowModal(true)} data-testid="create-agent-button">
              <Plus className="mr-2 h-4 w-4" />
              Create Agent
            </Button>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 border-b" style={{ borderColor: '#E2E8F0' }}>
          {[['agents', 'Agents'], ['analysis', 'Analysis']].map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className="px-4 py-2 text-sm font-semibold -mb-px border-b-2 transition-colors"
              style={{ borderColor: tab === k ? '#0748EE' : 'transparent', color: tab === k ? '#0748EE' : '#64748B' }}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'analysis' ? (
          <ToolAnalysis />
        ) : agents.length === 0 ? (
          <div className="py-16 text-center text-slate-600">
            <Bot className="h-12 w-12 text-slate-400 mx-auto mb-4" />
            No agents created yet
          </div>
        ) : (
          <div className="space-y-8">
            {bySection.map(section => (
              <div key={section.key}>
                <div className="flex items-center gap-3 mb-4">
                  <div className="flex items-center gap-2">
                    <div className="w-1 h-5 rounded-full" style={{ background: section.accent }} />
                    <h2 className="text-sm font-bold text-slate-900">{section.label}</h2>
                  </div>
                  <div className="flex-1 h-px bg-slate-200" />
                  <span className="text-xs text-slate-400">{section.items.length} agent{section.items.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {section.items.map(a => (
                    (a.id === '6fcb5c0e-7397-495c-af1e-9b1fe5faa2ad' || a.name === 'Myntra Ticket Finder')
                      ? <MyntraCard key={a.id} onClick={() => openAgent(a)} />
                      : RICH_META[a.name]
                        ? <RichAgentCard key={a.id} meta={RICH_META[a.name]} description={a.description} onClick={() => openAgent(a)} />
                        : <SimpleAgentCard key={a.id} agent={a} onClick={() => openAgent(a)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent onClose={() => setShowModal(false)}>
          <DialogHeader>
            <DialogTitle>Create New Agent</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="name">Agent Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Sales-Myntra"
                required
                data-testid="agent-name-input"
              />
            </div>
            <div>
              <Label htmlFor="description">Description</Label>
              <Input
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Enter agent description"
                data-testid="agent-description-input"
              />
            </div>
            <div className="flex items-center space-x-2 pt-2">
              <input
                type="checkbox"
                id="useBasicColumns"
                checked={formData.useBasicColumns}
                onChange={(e) => setFormData({ ...formData, useBasicColumns: e.target.checked })}
                className="rounded border-slate-300 text-indigo-600 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50 h-4 w-4"
              />
              <Label htmlFor="useBasicColumns" className="font-normal cursor-pointer text-slate-700">
                Include basic columns (id, month, year, etc.)
              </Label>
            </div>
            <div className="flex gap-3 pt-4">
              <Button type="button" variant="secondary" onClick={() => setShowModal(false)} className="flex-1">
                Cancel
              </Button>
              <Button type="submit" className="flex-1" data-testid="agent-submit-button">
                Create Agent
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
};

export default AgentsPage;

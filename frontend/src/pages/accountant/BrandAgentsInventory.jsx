import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { channelLogoSrc } from '../../components/ChannelLogo';
import { LayoutDashboard, Bot, TrendingUp, ChevronRight, ShoppingBag, GitBranch } from 'lucide-react';
import { Card, CardContent } from '../../components/ui/card';
import api from '../../lib/api';
import { toast } from 'sonner';
import { sidebarFor } from '../../lib/adminNav';
import { RECO_ID_TO_TYPE } from './AgentDispatch';
import WorkflowApplyModal from './WorkflowApplyModal';

// ── RECO-only visibility (unchanged) ───────────────────────────────────────
//   - REACT_APP_RECO_ONLY=true/false → explicit override, always wins.
//   - else localhost (dev) → show ALL agents; tunnel host → accountant view.
function isRecoOnly() {
  const env = process.env.REACT_APP_RECO_ONLY;
  if (env === 'true') return true;
  if (env === 'false') return false;
  const host = typeof window !== 'undefined' ? window.location.hostname : '';
  return host !== 'localhost' && host !== '127.0.0.1';
}
const RECO_ONLY = isRecoOnly();

const HIDDEN_WHEN_RECO_ONLY = new Set([
  '4e02cc5b-8fc8-4c79-8013-e7f510c850d5', // GSTR-2B vs Books (single-state) — accountants use multi-state
]);

// Rich metadata for RECO + MTR + Bank agents (matched by DB `name`).
const RECO_AGENT_META = {
  gstr_2b_books: {
    displayName: 'GSTR-2B vs Books', icon: '📂', category: 'GST Reconciliation',
    color: '#0748EE', bg: '#E8EFFE', border: '#A3BFF8', accuracy: '99.5%',
    fields: ['GSTR-2B File', 'Purchase Register', 'Debit Note Register'],
  },
  gstr_2b_books_multistate: {
    displayName: 'GSTR-2B vs Books (Multi-State)', icon: '🗺️', category: 'GST Reconciliation',
    color: '#7C3AED', bg: '#F5F3FF', border: '#C4B5FD', accuracy: '99.5%',
    fields: ['GSTR-2B × N States', 'Purchase Register × N States', 'Debit Note × N States'],
  },
  gstr_1_vs_books: {
    displayName: 'GSTR-1 vs Books', icon: '📊', category: 'GST Reconciliation',
    color: '#D97706', bg: '#FFFBEB', border: '#FDE68A', accuracy: '99.3%',
    fields: ['Tally Sales Export', 'GSTR-1 File', 'Amazon RTF (Optional)'],
  },
  einvoice_reco: {
    displayName: 'E-Invoice Reco', icon: '🧾', category: 'GST Reconciliation',
    color: '#0284C7', bg: '#F0F9FF', border: '#BAE6FD', accuracy: '99.6%',
    fields: ['E-Invoice Register', 'Books (Sales + Credit Note)'],
  },
  gstr_3b_tally_entry: {
    displayName: 'GSTR-3B Tally Entry', icon: '📒', category: 'Journal Entry',
    color: '#0F766E', bg: '#F0FDFA', border: '#99F6E4', accuracy: '99.9%',
    fields: ['GSTR-3B File'],
  },
  universal_bank_statement: {
    displayName: 'Universal Bank Statement', icon: '🌍', category: 'Bank & Finance',
    color: '#059669', bg: '#ECFDF5', border: '#A7F3D0', accuracy: '100.0%',
    fields: ['Bank Statement', 'Ledger Master'],
  },
  amazon_mtr_consolidator: {
    displayName: 'Amazon MTR Consolidator', icon: '🛒', category: 'Marketplace MIS',
    color: '#D97706', bg: '#FFFBEB', border: '#FDE68A', accuracy: '99.8%',
    fields: ['Drive Folder Link', 'B2B Report', 'B2C Report'],
  },
  credit_card_booking: {
    displayName: 'Credit Card Booking', icon: '💳', category: 'Bank & Finance',
    color: '#4338CA', bg: '#EEF2FF', border: '#C7D2FE', accuracy: '96.4%',
    fields: ['Credit Card Statement (PDF or Excel)'],
  },
  pdf_bank_extract: {
    displayName: 'PDF → Bank Statement', icon: '📄', category: 'Bank & Finance',
    color: '#0748EE', bg: '#E8EFFE', border: '#A3BFF8', accuracy: 'Auto-detect',
    fields: ['Bank Statement PDF'],
  },
  receivable_cycle: {
    displayName: 'Receivable Cycle', icon: '🔄', category: 'Receivables',
    color: '#0748EE', bg: '#E8EFFE', border: '#A3BFF8', accuracy: null,
    fields: ['Tally GST Report', 'Sales Order Combine', 'Courier COD Settlement', 'SRN Report'],
  },
  zepto_receivables: {
    displayName: 'Zepto Receivables', icon: '⚡', category: 'Receivables',
    color: '#6C2BD9', bg: '#F5F3FF', border: '#C4B5FD', accuracy: null,
    fields: ['Google Drive Folder (Tally + Zepto)'], logoSrc: channelLogoSrc('zepto'),
  },
  bank_tally_reco: {
    displayName: 'Bank Reco', icon: '🏦', category: 'Bank & Finance',
    color: '#0748EE', bg: '#EFF4FF', border: '#A3BFF8', accuracy: null,
    fields: ['Tally Daybook', 'Universal Bank Output'],
  },
  // Fake demo cards (no backend) — matched by their synthetic agent `name`.
  'Amazon Receivables': {
    displayName: 'Amazon Receivables', icon: '📦', category: 'Receivables',
    color: '#B45309', bg: '#FFF7ED', border: '#FED7AA', accuracy: null,
    fields: ['Amazon Settlement Report', 'Books'], logoSrc: channelLogoSrc('amazon'),
  },
  'Shopify Receivables': {
    displayName: 'Shopify Receivables', icon: '🛍️', category: 'Receivables',
    color: '#5E8E3E', bg: '#F0FDF4', border: '#BBF7D0', accuracy: null,
    fields: ['Shopify Payouts Export', 'Books'], logoSrc: channelLogoSrc('shopify'),
  },
};

// Fake demo agents injected into the Receivables section (no backend, no DB).
// Each has a _fakeRoute → a client-only dashboard page.
const FAKE_RECEIVABLES = [
  { id: '__amazon_receivables', name: 'Amazon Receivables', _fakeRoute: 'amazon-receivables',
    description: 'Track Amazon settlements against Books — chase overdue receivables and raise seller-support tickets for missing Order / Shipment / Settlement IDs.' },
  { id: '__shopify_receivables', name: 'Shopify Receivables', _fakeRoute: 'shopify-receivables',
    description: 'Reconcile Shopify payouts against Books — surface overdue receivables and raise tickets for missing Order / Fulfillment / Payout IDs.' },
];

// Category sections, in display order (mirrors the admin Agents page).
const SECTIONS = [
  { key: 'reco',        label: 'GST Reconciliation', accent: '#0748EE' },
  { key: 'bank',        label: 'Bank & Finance',     accent: '#059669' },
  { key: 'invoice',     label: 'Invoice',            accent: '#7C3AED' },
  { key: 'marketplace', label: 'Marketplace MIS',    accent: '#D97706' },
  { key: 'receivables', label: 'Receivables',        accent: '#8B5CF6' },
  { key: 'other',       label: 'Other',              accent: '#64748B' },
];

// Per-section default styling for agents without rich meta (sales/marketplace).
const SECTION_STYLE = {
  reco:        { category: 'GST Reconciliation', color: '#0748EE', bg: '#E8EFFE', border: '#A3BFF8' },
  bank:        { category: 'Bank & Finance',     color: '#059669', bg: '#ECFDF5', border: '#A7F3D0' },
  invoice:     { category: 'Invoice',            color: '#7C3AED', bg: '#F5F3FF', border: '#C4B5FD' },
  marketplace: { category: 'Marketplace MIS',    color: '#D97706', bg: '#FFFBEB', border: '#FDE68A' },
  receivables: { category: 'Receivables',        color: '#8B5CF6', bg: '#F5F3FF', border: '#C4B5FD' },
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

// Brand-colored monogram tiles per marketplace (brand color + short label — NOT the
// trademarked logo artwork). Iteration order matters: settlement/total before amazon/sales.
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

// Decide a section for any agent: rich meta wins, else infer from the name.
const sectionOf = (agent) => {
  const n = (agent.name || '').toLowerCase();
  if (/receivabl/.test(n)) return 'receivables';   // zepto_receivables, receivable_cycle, *_receivables
  if (RECO_AGENT_META[agent.name]) {
    if (n === 'universal_bank_statement' || n === 'pdf_bank_extract' || n === 'bank_tally_reco'
        || n === 'credit_card_booking') return 'bank';
    if (n === 'amazon_mtr_consolidator') return 'marketplace';
    if (n === 'receivable_cycle') return 'other';
    return 'reco';
  }
  if (/invoice/.test(n)) return 'invoice';
  if (/bank/.test(n)) return 'bank';
  if (/gstr|reco|tally|2b|3b/.test(n)) return 'reco';
  if (/amazon|flipkart|meesho|myntra|nykaa|ajio|jiomart|firstcry|shopify|blinkit|zepto|seller|marketplace|mtr|sales|total|limeroad|mirrow|cread/.test(n)) return 'marketplace';
  return 'other';
};

// Build a card meta for any agent (rich meta if known, else synthesized from section).
const metaFor = (agent) => {
  const rich = RECO_AGENT_META[agent.name];
  if (rich) return rich;
  const s = SECTION_STYLE[sectionOf(agent)] || SECTION_STYLE.other;
  return {
    displayName: agent.name, icon: channelIcon(agent.name), category: s.category,
    color: s.color, bg: s.bg, border: s.border, accuracy: null, fields: null,
    mono: channelBrand(agent.name), logoSrc: channelLogoSrc(agent.name),
  };
};

// ── Unified rich card (reco + sales/marketplace) ────────────────────────────
const AgentCard = ({ agent, assigned, onClick }) => {
  const meta = metaFor(agent);
  return (
    <div
      onClick={onClick}
      data-testid={`agent-inventory-card-${agent.id}`}
      className={`rounded-2xl border bg-white transition-all duration-200 flex flex-col overflow-hidden ${
        assigned ? 'cursor-pointer hover:shadow-lg hover:-translate-y-0.5' : 'opacity-60 cursor-not-allowed'
      }`}
      style={{ borderColor: meta.border }}
    >
      <div className="p-5 flex-1">
        <div className="flex items-start justify-between mb-3">
          {meta.logoSrc ? (
            <div className="w-11 h-11 rounded-xl flex items-center justify-center bg-white border overflow-hidden"
              style={{ borderColor: meta.border, padding: 6 }}>
              <img src={meta.logoSrc} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
            </div>
          ) : meta.mono ? (
            <div className="w-11 h-11 rounded-xl flex items-center justify-center font-extrabold text-base tracking-tight"
              style={{ background: meta.mono.bg, color: meta.mono.fg }}>
              {meta.mono.label}
            </div>
          ) : (
            <div className="w-11 h-11 rounded-xl flex items-center justify-center text-2xl"
              style={{ background: meta.bg, border: `1.5px solid ${meta.border}` }}>
              {meta.icon}
            </div>
          )}
          {meta.accuracy && (
            <span className="flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-full"
              style={{ background: meta.bg, color: meta.color, border: `1px solid ${meta.border}` }}>
              <TrendingUp className="w-3 h-3" /> {meta.accuracy}
            </span>
          )}
        </div>
        <h3 className="font-bold text-slate-900 text-base mb-1 leading-snug">{meta.displayName}</h3>
        <p className="text-slate-500 text-xs leading-relaxed mb-3 line-clamp-2">
          {agent.description || 'No description available'}
        </p>
        {meta.fields && (
          <div className="flex flex-wrap gap-1.5">
            {meta.fields.map(f => (
              <span key={f} className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-medium">{f}</span>
            ))}
          </div>
        )}
      </div>
      <div className="px-5 py-3 flex items-center justify-between border-t"
        style={{ borderColor: meta.border, background: meta.bg }}>
        <span className="text-xs font-bold uppercase tracking-wide" style={{ color: meta.color }}>{meta.category}</span>
        <span className="flex items-center gap-1 text-xs font-semibold" style={{ color: meta.color }}>
          {assigned ? 'Run Agent' : 'Not Assigned'}
          {assigned && <ChevronRight className="w-3.5 h-3.5" />}
        </span>
      </div>
    </div>
  );
};

// ── Workflow card — saved multi-sheet transform recipes, scoped to a parent agent ──
const WORKFLOW_ACCENT = { color: '#4F46E5', bg: '#EEF2FF', border: '#C7D2FE' };
const WorkflowCard = ({ workflow, onClick }) => {
  const sheets = workflow.sheets || [];
  return (
    <div
      onClick={onClick}
      data-testid={`workflow-inventory-card-${workflow.id}`}
      className="rounded-2xl border bg-white transition-all duration-200 flex flex-col overflow-hidden cursor-pointer hover:shadow-lg hover:-translate-y-0.5"
      style={{ borderColor: WORKFLOW_ACCENT.border }}
    >
      <div className="p-5 flex-1">
        <div className="flex items-start justify-between mb-3">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center"
            style={{ background: WORKFLOW_ACCENT.bg, border: `1.5px solid ${WORKFLOW_ACCENT.border}` }}>
            <GitBranch className="w-5 h-5" style={{ color: WORKFLOW_ACCENT.color }} />
          </div>
          <span className="text-xs font-semibold px-2 py-1 rounded-full"
            style={{ background: WORKFLOW_ACCENT.bg, color: WORKFLOW_ACCENT.color, border: `1px solid ${WORKFLOW_ACCENT.border}` }}>
            {sheets.length} sheet{sheets.length !== 1 ? 's' : ''}
          </span>
        </div>
        <h3 className="font-bold text-slate-900 text-base mb-1 leading-snug">{workflow.name}</h3>
        <p className="text-slate-500 text-xs leading-relaxed mb-3 line-clamp-2">
          {workflow.description || 'Saved multi-sheet transform workflow'}
        </p>
      </div>
      <div className="px-5 py-3 flex items-center justify-between border-t"
        style={{ borderColor: WORKFLOW_ACCENT.border, background: WORKFLOW_ACCENT.bg }}>
        <span className="text-xs font-bold uppercase tracking-wide truncate max-w-[65%]" style={{ color: WORKFLOW_ACCENT.color }} title={workflow.agentName}>
          {workflow.agentName || 'Workflow'}
        </span>
        <span className="flex items-center gap-1 text-xs font-semibold shrink-0" style={{ color: WORKFLOW_ACCENT.color }}>
          Run <ChevronRight className="w-3.5 h-3.5" />
        </span>
      </div>
    </div>
  );
};

const BrandAgentsInventory = () => {
  const { brandId } = useParams();
  const navigate = useNavigate();
  const [allAgents, setAllAgents] = useState([]);
  const [assignedAgents, setAssignedAgents] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [runningWorkflow, setRunningWorkflow] = useState(null);

  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'All Agents', icon: Bot, testId: 'nav-agents' },
  ]);

  useEffect(() => {
    fetchData();
  }, [brandId]);

  const fetchData = async () => {
    try {
      const [allAgentsRes, assignedAgentsRes, workflowsRes] = await Promise.all([
        api.get('/api/agents'),
        api.get(`/api/brands/${brandId}/agents`),
        api.get('/api/workflows')
      ]);
      setAllAgents(allAgentsRes.data);
      setAssignedAgents(assignedAgentsRes.data);
      setWorkflows(workflowsRes.data);
    } catch (error) {
      toast.error('Failed to load agents');
    } finally {
      setLoading(false);
    }
  };

  const isAssigned = (agentId) => assignedAgents.some(a => a.id === agentId);

  // RECO-only build shows the reco agents PLUS the sales/marketplace agents (Sales-*, Nykaa,
  // Settlement-Amazon, Total-Sales-Analyzer, and order-cycle agents e.g. Shopify-Order-Cycle —
  // these route to AgentWorkspace which has a dedicated order-cycle workspace). Legacy
  // Amazon/Flipkart/Myntra dupes and Meesho/AJIO (no backend) are excluded. Invoice Process IS
  // shown (accountants review AI-extracted invoices). Full build shows everything.
  const isSalesMarketplace = (a) =>
    /^sales-/i.test(a.name || '') ||
    /order[-\s]?cycle/i.test(a.name || '') ||
    ['nykaa', 'settlement-amazon', 'total-sales-analyzer'].includes((a.name || '').toLowerCase());
  const isInvoice = (a) => (a.name || '').toLowerCase() === 'invoice process';
  const visibleAgents = RECO_ONLY
    ? allAgents.filter(agent => (RECO_ID_TO_TYPE[agent.id] || isSalesMarketplace(agent) || isInvoice(agent)) && !HIDDEN_WHEN_RECO_ONLY.has(agent.id))
    : allAgents;

  // Group visible agents into category sections; inject the fake receivables
  // demo cards into the Receivables section, then drop empty sections.
  const bySection = SECTIONS
    .map(s => {
      let items = visibleAgents.filter(a => sectionOf(a) === s.key);
      if (s.key === 'receivables') items = [...items, ...FAKE_RECEIVABLES];
      return { ...s, items };
    })
    .filter(s => s.items.length > 0);

  // Only surface workflows whose parent agent is actually assigned to this brand —
  // same gate as agent cards themselves.
  const visibleWorkflows = workflows.filter(wf => isAssigned(wf.agent_id));

  const handleAgentClick = (agent) => {
    if (!isAssigned(agent.id)) {
      toast.info('This agent is not assigned to this brand');
      return;
    }
    navigate(`/brands/${brandId}/agents/${agent.id}`);
  };

  if (loading) {
    return (
      <DashboardLayout sidebarItems={sidebarItems}>
        <div className="p-6 flex items-center justify-center min-h-[400px]">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-slate-900"></div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6" data-testid="agents-inventory-page">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Agents Inventory</h1>
          <p className="text-slate-600 mt-1">All available processing agents in the system</p>
        </div>

        <div className="space-y-8">
          {bySection.map(section => (
            <div key={section.key}>
              <div className="flex items-center gap-3 mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-1 h-5 rounded-full" style={{ background: section.accent }} />
                  <h2 className="text-sm font-bold text-slate-900">{section.label}</h2>
                </div>
                <div className="flex-1 h-px bg-slate-200" />
                <span className="text-xs text-slate-400">
                  {section.items.length} agent{section.items.length !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" data-testid={`agents-section-${section.key}`}>
                {section.items.map(agent => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    assigned={agent._fakeRoute ? true : isAssigned(agent.id)}
                    onClick={() => agent._fakeRoute
                      ? navigate(`/brands/${brandId}/${agent._fakeRoute}`)
                      : handleAgentClick(agent)}
                  />
                ))}
              </div>
            </div>
          ))}

          {visibleWorkflows.length > 0 && (
            <div key="workflows">
              <div className="flex items-center gap-3 mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-1 h-5 rounded-full" style={{ background: WORKFLOW_ACCENT.color }} />
                  <h2 className="text-sm font-bold text-slate-900">Workflows</h2>
                </div>
                <div className="flex-1 h-px bg-slate-200" />
                <span className="text-xs text-slate-400">
                  {visibleWorkflows.length} workflow{visibleWorkflows.length !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" data-testid="agents-section-workflows">
                {visibleWorkflows.map(wf => (
                  <WorkflowCard key={wf.id} workflow={wf} onClick={() => setRunningWorkflow(wf)} />
                ))}
              </div>
            </div>
          )}
        </div>

        {visibleAgents.length === 0 && visibleWorkflows.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center">
              <Bot className="h-12 w-12 text-slate-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-slate-900 mb-2">No Agents Available</h3>
              <p className="text-slate-600">No agents have been created in the system yet.</p>
            </CardContent>
          </Card>
        )}
      </div>

      <WorkflowApplyModal
        open={!!runningWorkflow}
        onClose={() => setRunningWorkflow(null)}
        agentId={runningWorkflow?.agent_id}
        brandId={brandId}
        initialWorkflow={runningWorkflow}
      />
    </DashboardLayout>
  );
};

export default BrandAgentsInventory;

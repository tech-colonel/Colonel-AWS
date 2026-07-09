import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { LayoutDashboard, Bot, TrendingUp, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import api from '../../lib/api';
import { toast } from 'sonner';
import { sidebarFor } from '../../lib/adminNav';
import { RECO_ID_TO_TYPE } from './AgentDispatch';

// Decide whether to show ONLY the 5 RECO agents (accountant view) or ALL agents (dev view).
// Resolved at RUNTIME so env-file precedence can't bake in the wrong value:
//   - REACT_APP_RECO_ONLY=true/false → explicit override (e.g. via .env.local), always wins.
//   - else served from localhost (dev on :3000) → show ALL agents (main branch + RECO).
//   - else (served from a tunnel: Cloudflare/ngrok → accountants) → show ONLY the 5 RECO agents.
function isRecoOnly() {
  const env = process.env.REACT_APP_RECO_ONLY;
  if (env === 'true') return true;
  if (env === 'false') return false;
  const host = typeof window !== 'undefined' ? window.location.hostname : '';
  return host !== 'localhost' && host !== '127.0.0.1';
}
const RECO_ONLY = isRecoOnly();

// Agents hidden from the accountant/tunnel (RECO-only) view but still shown on local dev.
const HIDDEN_WHEN_RECO_ONLY = new Set([
  'd0000000-0000-0000-0000-000000000001', // GSTR-2B vs Books (single-state) — accountants use multi-state
]);

// Rich metadata for RECO agent cards
const RECO_AGENT_META = {
  gstr_2b_books: {
    displayName: 'GSTR-2B vs Books',
    icon: '📂',
    category: 'GST Reconciliation',
    color: '#0748EE', bg: '#E8EFFE', border: '#A3BFF8',
    accuracy: '99.5%',
    fields: ['GSTR-2B File', 'Purchase Register', 'Debit Note Register'],
  },
  gstr_2b_books_multistate: {
    displayName: 'GSTR-2B vs Books (Multi-State)',
    icon: '🗺️',
    category: 'GST Reconciliation',
    color: '#7C3AED', bg: '#F5F3FF', border: '#C4B5FD',
    accuracy: '99.5%',
    fields: ['GSTR-2B × N States', 'Purchase Register × N States', 'Debit Note × N States'],
  },
  gstr_1_vs_books: {
    displayName: 'GSTR-1 vs Books',
    icon: '📊',
    category: 'GST Reconciliation',
    color: '#D97706', bg: '#FFFBEB', border: '#FDE68A',
    accuracy: '99.3%',
    fields: ['Tally Sales Export', 'GSTR-1 File', 'Amazon RTF (Optional)'],
  },
  gstr_3b_tally_entry: {
    displayName: 'GSTR-3B Tally Entry',
    icon: '📒',
    category: 'Journal Entry',
    color: '#0F766E', bg: '#F0FDFA', border: '#99F6E4',
    accuracy: '99.9%',
    fields: ['GSTR-3B File'],
  },
  universal_bank_statement: {
    displayName: 'Universal Bank Statement',
    icon: '🌍',
    category: 'Bank & Finance',
    color: '#059669', bg: '#ECFDF5', border: '#A7F3D0',
    accuracy: '100.0%',
    fields: ['Bank Statement', 'Ledger Master'],
  },
  amazon_mtr_consolidator: {
    displayName: 'Amazon MTR Consolidator',
    icon: '🛒',
    category: 'Marketplace MIS',
    color: '#D97706', bg: '#FFFBEB', border: '#FDE68A',
    accuracy: '99.8%',
    fields: ['Drive Folder Link', 'B2B Report', 'B2C Report'],
  },
  pdf_bank_extract: {
    displayName: 'PDF → Bank Statement',
    icon: '📄',
    category: 'Bank & Finance',
    color: '#0748EE', bg: '#E8EFFE', border: '#A3BFF8',
    accuracy: 'Auto-detect',
    fields: ['Bank Statement PDF'],
  },
  zepto_receivables: {
    displayName: 'Zepto Receivables',
    icon: '💳',
    category: 'Receivables',
    color: '#6366F1', bg: '#EEF2FF', border: '#C7D2FE',
    accuracy: '—',
    fields: ['Google Drive Folder URL'],
  },
};

const BrandAgentsInventory = () => {
  const { brandId } = useParams();
  const navigate = useNavigate();
  const [allAgents, setAllAgents] = useState([]);
  const [assignedAgents, setAssignedAgents] = useState([]);
  const [loading, setLoading] = useState(true);

  const sidebarItems = sidebarFor([
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'Agents', icon: Bot, testId: 'nav-agents' },
  ]);

  useEffect(() => {
    fetchData();
  }, [brandId]);

  const fetchData = async () => {
    try {
      const [allAgentsRes, assignedAgentsRes] = await Promise.all([
        api.get('/api/agents'),
        api.get(`/api/brands/${brandId}/agents`)
      ]);
      setAllAgents(allAgentsRes.data);
      setAssignedAgents(assignedAgentsRes.data);
    } catch (error) {
      toast.error('Failed to load agents');
    } finally {
      setLoading(false);
    }
  };

  const isAssigned = (agentId) => assignedAgents.some(a => a.id === agentId);

  // RECO-only build hides main-branch agents; full build (port 3000) shows everything.
  const visibleAgents = RECO_ONLY
    ? allAgents.filter(agent => RECO_ID_TO_TYPE[agent.id] && !HIDDEN_WHEN_RECO_ONLY.has(agent.id))
    : allAgents;

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

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" data-testid="agents-inventory-grid">
          {visibleAgents.map((agent) => {
            const assigned = isAssigned(agent.id);
            const recoMeta = RECO_AGENT_META[agent.name];

            // Myntra Ticket Finder — distinctive cream / monospace card (D'Chica ops-hub style)
            if (agent.id === 'd0000000-0000-0000-0000-000000000009' || agent.name === 'Myntra Ticket Finder') {
              return (
                <div
                  key={agent.id}
                  onClick={() => assigned && handleAgentClick(agent)}
                  data-testid={`agent-inventory-card-${agent.id}`}
                  style={{
                    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                    background: '#FAF7EC',
                    border: '2px solid #1A1A1A',
                    boxShadow: '6px 6px 0 rgba(26,26,26,0.9)',
                    borderRadius: 4,
                    padding: '20px 22px',
                    display: 'flex',
                    flexDirection: 'column',
                    cursor: assigned ? 'pointer' : 'not-allowed',
                    opacity: assigned ? 1 : 0.6,
                    transition: 'transform .15s ease, box-shadow .15s ease',
                  }}
                  onMouseEnter={e => { if (assigned) { e.currentTarget.style.transform = 'translate(-2px,-2px)'; e.currentTarget.style.boxShadow = '8px 8px 0 rgba(26,26,26,0.9)'; } }}
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
                      {assigned ? 'Run after each settlement cycle' : 'Not assigned'}
                    </span>
                    <span style={{ fontSize: 16, color: '#1A1A1A' }}>→</span>
                  </div>
                </div>
              );
            }

            if (recoMeta) {
              // RECO agent — rich card matching RecoSuite style
              return (
                <div
                  key={agent.id}
                  onClick={() => handleAgentClick(agent)}
                  data-testid={`agent-inventory-card-${agent.id}`}
                  className={`rounded-2xl border bg-white transition-all duration-200 flex flex-col overflow-hidden ${
                    assigned
                      ? 'cursor-pointer hover:shadow-lg hover:-translate-y-0.5'
                      : 'opacity-60 cursor-not-allowed'
                  }`}
                  style={{ borderColor: recoMeta.border }}
                >
                  <div className="p-5 flex-1">
                    <div className="flex items-start justify-between mb-3">
                      <div
                        className="w-11 h-11 rounded-xl flex items-center justify-center text-2xl"
                        style={{ background: recoMeta.bg, border: `1.5px solid ${recoMeta.border}` }}
                      >
                        {recoMeta.icon}
                      </div>
                      <span
                        className="flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-full"
                        style={{ background: recoMeta.bg, color: recoMeta.color, border: `1px solid ${recoMeta.border}` }}
                      >
                        <TrendingUp className="w-3 h-3" />
                        {recoMeta.accuracy}
                      </span>
                    </div>
                    <h3 className="font-bold text-slate-900 text-base mb-1 leading-snug">
                      {recoMeta.displayName}
                    </h3>
                    <p className="text-slate-500 text-xs leading-relaxed mb-3 line-clamp-2">
                      {agent.description || 'No description available'}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {recoMeta.fields.map(f => (
                        <span
                          key={f}
                          className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-medium"
                        >
                          {f}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div
                    className="px-5 py-3 flex items-center justify-between border-t"
                    style={{ borderColor: recoMeta.border, background: recoMeta.bg }}
                  >
                    <span
                      className="text-xs font-bold uppercase tracking-wide"
                      style={{ color: recoMeta.color }}
                    >
                      {recoMeta.category}
                    </span>
                    <span
                      className="flex items-center gap-1 text-xs font-semibold"
                      style={{ color: recoMeta.color }}
                    >
                      {assigned ? 'Run Agent' : 'Not Assigned'}
                      {assigned && <ChevronRight className="w-3.5 h-3.5" />}
                    </span>
                  </div>
                </div>
              );
            }

            // Non-RECO (sales / other) agent — existing generic card style
            return (
              <Card
                key={agent.id}
                className={`hover:shadow-lg transition-shadow ${assigned ? 'cursor-pointer' : 'opacity-75'}`}
                onClick={() => handleAgentClick(agent)}
                data-testid={`agent-inventory-card-${agent.id}`}
              >
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="w-12 h-12 bg-slate-100 rounded-lg flex items-center justify-center mb-3">
                      <Bot className="h-6 w-6 text-slate-600" />
                    </div>
                    {assigned ? (
                      <Badge variant="success" data-testid={`agent-assigned-badge-${agent.id}`}>
                        Assigned
                      </Badge>
                    ) : (
                      <Badge variant="secondary" data-testid={`agent-not-assigned-badge-${agent.id}`}>
                        Not Assigned
                      </Badge>
                    )}
                  </div>
                  <CardTitle>{agent.name}</CardTitle>
                  <CardDescription className="line-clamp-2">
                    {agent.description || 'No description available'}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {assigned ? (
                    <p className="text-sm text-slate-600">Click to open agent workspace</p>
                  ) : (
                    <p className="text-sm text-slate-500">Contact admin to assign this agent</p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>

        {visibleAgents.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center">
              <Bot className="h-12 w-12 text-slate-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-slate-900 mb-2">No Agents Available</h3>
              <p className="text-slate-600">No agents have been created in the system yet.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
};

export default BrandAgentsInventory;

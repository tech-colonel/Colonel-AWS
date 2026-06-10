import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { LayoutDashboard, Bot, TrendingUp, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import api from '../../lib/api';
import { toast } from 'sonner';

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
};

const BrandAgentsInventory = () => {
  const { brandId } = useParams();
  const navigate = useNavigate();
  const [allAgents, setAllAgents] = useState([]);
  const [assignedAgents, setAssignedAgents] = useState([]);
  const [loading, setLoading] = useState(true);

  const sidebarItems = [
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'Agents', icon: Bot, testId: 'nav-agents' },
  ];

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
          {allAgents.map((agent) => {
            const assigned = isAssigned(agent.id);
            const recoMeta = RECO_AGENT_META[agent.name];

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

        {allAgents.length === 0 && (
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

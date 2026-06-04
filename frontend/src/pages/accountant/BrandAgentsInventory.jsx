import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { LayoutDashboard, Bot, ClipboardList } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import api from '../../lib/api';
import { toast } from 'sonner';

// Maps agent name → reco route slug. Covers both snake_case (colonel-automation) and Title-Case (colonel-v2).
const RECO_ROUTE_MAP = {
  'gstr_2b_books':            'gstr_2b_books',
  'GSTR-2B-Books':            'gstr_2b_books',
  'gstr_2b_books_multistate': 'gstr_2b_books_multistate',
  'GSTR-2B-Books-Multistate': 'gstr_2b_books_multistate',
  'gstr_3b_tally_entry':      'gstr_3b_tally_entry',
  'GSTR-3B-Tally-Entry':      'gstr_3b_tally_entry',
  'universal_bank_statement': 'universal_bank_statement',
  'Universal-Bank-Statement': 'universal_bank_statement',
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
    { path: `/brands/${brandId}/reco`, label: 'Reconciliation', icon: ClipboardList, testId: 'nav-reco' }
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

  const isAssigned = (agentId) => {
    return assignedAgents.some(a => a.id === agentId);
  };

  const handleAgentClick = (agent) => {
    if (!isAssigned(agent.id)) {
      toast.info('This agent is not assigned to this brand');
      return;
    }
    const recoSlug = RECO_ROUTE_MAP[agent.name];
    if (recoSlug) {
      navigate(`/brands/${brandId}/reco/${recoSlug}`);
    } else {
      navigate(`/brands/${brandId}/agents/${agent.id}`);
    }
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
          {allAgents.filter(agent => !RECO_ROUTE_MAP[agent.name]).map((agent) => {
            const assigned = isAssigned(agent.id);
            
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
                    <p className="text-sm text-slate-600">
                      Click to open agent workspace
                    </p>
                  ) : (
                    <p className="text-sm text-slate-500">
                      Contact admin to assign this agent
                    </p>
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

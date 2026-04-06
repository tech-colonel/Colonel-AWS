import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { LayoutDashboard, Bot, BarChart3 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import api from '../../lib/api';
import { toast } from 'sonner';

const BrandDashboard = () => {
  const { brandId } = useParams();
  const navigate = useNavigate();
  const [brand, setBrand] = useState(null);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAgentPicker, setShowAgentPicker] = useState(false);

  const sidebarItems = [
    { path: `/brands/${brandId}/dashboard`, label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
    { path: `/brands/${brandId}/agents`, label: 'Agents', icon: Bot, testId: 'nav-agents' }
  ];

  useEffect(() => {
    fetchData();
  }, [brandId]);

  const fetchData = async () => {
    try {
      const [brandRes, agentsRes] = await Promise.all([
        api.get(`/api/brands/${brandId}`),
        api.get(`/api/brands/${brandId}/agents`)
      ]);
      setBrand(brandRes.data);
      setAgents(agentsRes.data);
    } catch (error) {
      toast.error('Failed to load brand data');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-slate-900"></div>
      </div>
    );
  }

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6" data-testid="brand-dashboard">
        <div className="mb-8 flex justify-between items-start">
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate('/brands')}
              className="mb-4"
              data-testid="back-to-brands"
            >
              ← Back to Brands
            </Button>
            <h1 className="text-3xl font-bold text-slate-900 tracking-tight">{brand?.name}</h1>
            <p className="text-slate-600 mt-1">{brand?.description}</p>
          </div>
          
          <div>
            <Button
              onClick={() => {
                if (agents.length === 0) {
                  toast.error("No agents available for analytics");
                  return;
                }
                setShowAgentPicker(true);
              }}
              variant="default"
              disabled={agents.length === 0}
            >
              <BarChart3 className="mr-2 h-4 w-4" />
              📊 Global CFO Dashboard
            </Button>
          </div>
        </div>

        <div className="mb-8">
          <h2 className="text-xl font-semibold mb-4">Assigned Agents</h2>
          {agents.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <Bot className="h-12 w-12 text-slate-400 mx-auto mb-4" />
                <p className="text-slate-600">No agents assigned to this brand yet</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" data-testid="agents-grid">
              {agents.map((agent) => (
                <Card
                  key={agent.id}
                  className="hover:shadow-lg transition-shadow cursor-pointer"
                  onClick={() => navigate(`/brands/${brandId}/agents/${agent.id}`)}
                  data-testid={`agent-card-${agent.id}`}
                >
                  <CardHeader>
                    <CardTitle>{agent.name}</CardTitle>
                    <CardDescription className="line-clamp-2">{agent.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button className="w-full" size="sm" data-testid={`open-agent-${agent.id}`}>
                      Open Agent
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      <Dialog open={showAgentPicker} onOpenChange={setShowAgentPicker}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-2xl text-center font-bold text-slate-900">Select Analytics Agent</DialogTitle>
            <p className="text-center text-slate-500 mt-2">
              Choose an agent to view its corresponding CFO Revenue Dashboard.
            </p>
          </DialogHeader>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 p-4 mt-4">
            {agents.map((agent) => (
              <Card 
                key={agent.id} 
                className="cursor-pointer hover:shadow-xl transition-all border-2 border-transparent hover:border-slate-800 bg-gradient-to-br from-slate-50 to-white"
                onClick={() => {
                  setShowAgentPicker(false);
                  navigate(`/brands/${brandId}/agents/${agent.id}`, { state: { openCfo: true } });
                }}
              >
                <CardHeader className="text-center pb-2">
                    <div className="w-14 h-14 rounded-full bg-slate-200 flex items-center justify-center mx-auto mb-3 shadow-inner">
                      <BarChart3 className="text-slate-700 w-7 h-7" />
                    </div>
                    <CardTitle className="text-lg">{agent.name}</CardTitle>
                </CardHeader>
                <CardContent className="text-center text-sm text-slate-500">
                    <p className="line-clamp-2">{agent.description || 'View financial analytics for this portal.'}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
};

export default BrandDashboard;
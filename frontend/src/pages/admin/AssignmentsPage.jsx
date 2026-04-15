import React, { useState, useEffect } from 'react';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { LayoutDashboard, Building2, Bot, Users as UsersIcon, Link as LinkIcon, Loader2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Label } from '../../components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import api from '../../lib/api';
import { toast } from 'sonner';

const sidebarItems = [
  { path: '/admin', label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
  { path: '/admin/brands', label: 'Brands', icon: Building2, testId: 'nav-brands' },
  { path: '/admin/agents', label: 'Agents', icon: Bot, testId: 'nav-agents' },
  { path: '/admin/users', label: 'Users', icon: UsersIcon, testId: 'nav-users' },
  { path: '/admin/assignments', label: 'Assignments', icon: LinkIcon, testId: 'nav-assignments' }
];

const AssignmentsPage = () => {
  const [brands, setBrands] = useState([]);
  const [agents, setAgents] = useState([]);
  const [users, setUsers] = useState([]);
  const [showAgentModal, setShowAgentModal] = useState(false);
  const [showUserModal, setShowUserModal] = useState(false);
  const [agentForm, setAgentForm] = useState({ brand_id: '', agent_id: '' });
  const [userForm, setUserForm] = useState({ brand_id: '', user_id: '' });
  const [loading, setLoading] = useState(true);

  // Already-assigned tracking
  const [assignedAgentIds, setAssignedAgentIds] = useState([]);
  const [assignedUserIds, setAssignedUserIds] = useState([]);
  const [loadingAssigned, setLoadingAssigned] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [brandsRes, agentsRes, usersRes] = await Promise.all([
        api.get('/api/brands'),
        api.get('/api/agents'),
        api.get('/api/users')
      ]);
      setBrands(brandsRes.data || []);
      setAgents(agentsRes.data || []);
      setUsers((usersRes.data || []).filter(u => u.role !== 'admin'));
    } catch (error) {
      console.error('Failed to load data:', error);
      toast.error('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  // When brand changes in the Agent modal — fetch already-assigned agents for that brand
  const handleAgentBrandChange = async (brandId) => {
    setAgentForm({ brand_id: brandId, agent_id: '' });
    setAssignedAgentIds([]);
    if (!brandId) return;
    setLoadingAssigned(true);
    try {
      const res = await api.get(`/api/brands/${brandId}/agents`);
      const ids = (res.data || []).map(a => String(a.id));
      setAssignedAgentIds(ids);
    } catch (err) {
      console.error('Failed to load brand agents:', err);
    } finally {
      setLoadingAssigned(false);
    }
  };

  // When brand changes in the User modal — fetch already-assigned users for that brand
  const handleUserBrandChange = async (brandId) => {
    setUserForm({ brand_id: brandId, user_id: '' });
    setAssignedUserIds([]);
    if (!brandId) return;
    setLoadingAssigned(true);
    try {
      const res = await api.get(`/api/brands/${brandId}/users`);
      const ids = (res.data || []).map(u => String(u.id));
      setAssignedUserIds(ids);
    } catch (err) {
      console.error('Failed to load brand users:', err);
    } finally {
      setLoadingAssigned(false);
    }
  };

  const handleAssignAgent = async (e) => {
    e.preventDefault();
    try {
      await api.post('/api/agents/assign', agentForm);
      toast.success('Agent assigned to brand successfully');
      setShowAgentModal(false);
      setAgentForm({ brand_id: '', agent_id: '' });
      setAssignedAgentIds([]);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to assign agent');
    }
  };

  const handleAssignUser = async (e) => {
    e.preventDefault();
    try {
      await api.post('/api/brands/assign-user', userForm);
      toast.success('User assigned to brand successfully');
      setShowUserModal(false);
      setUserForm({ brand_id: '', user_id: '' });
      setAssignedUserIds([]);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to assign user');
    }
  };

  // Filtered lists: exclude already-assigned items
  const availableAgents = agents.filter(a => !assignedAgentIds.includes(String(a.id)));
  const availableUsers = users.filter(u => !assignedUserIds.includes(String(u.id)));

  if (loading) {
    return (
      <DashboardLayout sidebarItems={sidebarItems}>
        <div className="p-6 flex items-center justify-center min-h-[400px]">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-slate-900 mx-auto"></div>
            <p className="mt-4 text-slate-600">Loading...</p>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6" data-testid="assignments-page">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Assignments</h1>
          <p className="text-slate-600 mt-1">Assign agents and users to brands</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Assign Agent to Brand</CardTitle>
              <CardDescription>Link processing agents to brand accounts</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 mb-4 text-sm text-slate-600">
                <p>Brands: {brands.length}</p>
                <p>Agents: {agents.length}</p>
              </div>
              <Button
                onClick={() => { setShowAgentModal(true); setAgentForm({ brand_id: '', agent_id: '' }); setAssignedAgentIds([]); }}
                className="w-full"
                data-testid="assign-agent-button"
                disabled={brands.length === 0 || agents.length === 0}
              >
                <Bot className="mr-2 h-4 w-4" />
                Assign Agent
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Assign User to Brand</CardTitle>
              <CardDescription>Grant user access to brand accounts</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 mb-4 text-sm text-slate-600">
                <p>Brands: {brands.length}</p>
                <p>Users: {users.length}</p>
              </div>
              <Button
                onClick={() => { setShowUserModal(true); setUserForm({ brand_id: '', user_id: '' }); setAssignedUserIds([]); }}
                className="w-full"
                data-testid="assign-user-button"
                disabled={brands.length === 0 || users.length === 0}
              >
                <UsersIcon className="mr-2 h-4 w-4" />
                Assign User
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── Assign Agent Modal ─────────────────────────────── */}
      <Dialog open={showAgentModal} onOpenChange={setShowAgentModal}>
        <DialogContent onClose={() => { setShowAgentModal(false); setAssignedAgentIds([]); }}>
          <DialogHeader>
            <DialogTitle>Assign Agent to Brand</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAssignAgent} className="space-y-4">

            {/* Step 1: Select Brand */}
            <div>
              <Label htmlFor="brand">Select Brand *</Label>
              <select
                id="brand"
                value={agentForm.brand_id}
                onChange={(e) => handleAgentBrandChange(e.target.value)}
                required
                data-testid="agent-brand-select"
                className="flex h-9 w-full items-center justify-between rounded-md border border-slate-200 bg-transparent px-3 py-2 text-sm shadow-sm mt-2"
              >
                <option value="">Choose a brand</option>
                {brands.map((brand) => (
                  <option key={brand.id} value={brand.id}>{brand.name}</option>
                ))}
              </select>
            </div>

            {/* Step 2: Select Agent — only visible after brand is chosen */}
            {agentForm.brand_id && (
              <div>
                <Label htmlFor="agent">Select Agent *</Label>
                {loadingAssigned ? (
                  <div className="flex items-center gap-2 mt-2 text-sm text-slate-500">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading available agents…
                  </div>
                ) : availableAgents.length === 0 ? (
                  <p className="mt-2 text-sm text-amber-600 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                    ✓ All agents are already assigned to this brand.
                  </p>
                ) : (
                  <select
                    id="agent"
                    value={agentForm.agent_id}
                    onChange={(e) => setAgentForm({ ...agentForm, agent_id: e.target.value })}
                    required
                    data-testid="agent-agent-select"
                    className="flex h-9 w-full items-center justify-between rounded-md border border-slate-200 bg-transparent px-3 py-2 text-sm shadow-sm mt-2"
                  >
                    <option value="">Choose an agent</option>
                    {availableAgents.map((agent) => (
                      <option key={agent.id} value={agent.id}>{agent.name}</option>
                    ))}
                  </select>
                )}
                {assignedAgentIds.length > 0 && (
                  <p className="mt-1 text-xs text-slate-400">
                    {assignedAgentIds.length} agent{assignedAgentIds.length > 1 ? 's' : ''} already assigned to this brand (hidden)
                  </p>
                )}
              </div>
            )}

            <div className="flex gap-3 pt-4">
              <Button
                type="button"
                variant="secondary"
                onClick={() => { setShowAgentModal(false); setAssignedAgentIds([]); }}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="flex-1"
                data-testid="agent-submit-button"
                disabled={!agentForm.brand_id || !agentForm.agent_id || loadingAssigned}
              >
                Assign
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Assign User Modal ──────────────────────────────── */}
      <Dialog open={showUserModal} onOpenChange={setShowUserModal}>
        <DialogContent onClose={() => { setShowUserModal(false); setAssignedUserIds([]); }}>
          <DialogHeader>
            <DialogTitle>Assign User to Brand</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAssignUser} className="space-y-4">

            {/* Step 1: Select Brand */}
            <div>
              <Label htmlFor="user-brand">Select Brand *</Label>
              <select
                id="user-brand"
                value={userForm.brand_id}
                onChange={(e) => handleUserBrandChange(e.target.value)}
                required
                data-testid="user-brand-select"
                className="flex h-9 w-full items-center justify-between rounded-md border border-slate-200 bg-transparent px-3 py-2 text-sm shadow-sm mt-2"
              >
                <option value="">Choose a brand</option>
                {brands.map((brand) => (
                  <option key={brand.id} value={brand.id}>{brand.name}</option>
                ))}
              </select>
            </div>

            {/* Step 2: Select User — only visible after brand is chosen */}
            {userForm.brand_id && (
              <div>
                <Label htmlFor="user">Select User *</Label>
                {loadingAssigned ? (
                  <div className="flex items-center gap-2 mt-2 text-sm text-slate-500">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading available users…
                  </div>
                ) : availableUsers.length === 0 ? (
                  <p className="mt-2 text-sm text-amber-600 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                    ✓ All users are already assigned to this brand.
                  </p>
                ) : (
                  <select
                    id="user"
                    value={userForm.user_id}
                    onChange={(e) => setUserForm({ ...userForm, user_id: e.target.value })}
                    required
                    data-testid="user-user-select"
                    className="flex h-9 w-full items-center justify-between rounded-md border border-slate-200 bg-transparent px-3 py-2 text-sm shadow-sm mt-2"
                  >
                    <option value="">Choose a user</option>
                    {availableUsers.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name} ({user.role})
                      </option>
                    ))}
                  </select>
                )}
                {assignedUserIds.length > 0 && (
                  <p className="mt-1 text-xs text-slate-400">
                    {assignedUserIds.length} user{assignedUserIds.length > 1 ? 's' : ''} already assigned to this brand (hidden)
                  </p>
                )}
              </div>
            )}

            <div className="flex gap-3 pt-4">
              <Button
                type="button"
                variant="secondary"
                onClick={() => { setShowUserModal(false); setAssignedUserIds([]); }}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="flex-1"
                data-testid="user-submit-button"
                disabled={!userForm.brand_id || !userForm.user_id || loadingAssigned}
              >
                Assign
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
};

export default AssignmentsPage;
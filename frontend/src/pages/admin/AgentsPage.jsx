import React, { useState, useEffect } from 'react';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { LayoutDashboard, Building2, Bot, Users as UsersIcon, Link as LinkIcon, Plus } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/modal';
import { Badge } from '../../components/ui/badge';
import api from '../../lib/api';
import { toast } from 'sonner';
import { format } from 'date-fns';

const sidebarItems = [
  { path: '/admin', label: 'Dashboard', icon: LayoutDashboard, testId: 'nav-dashboard' },
  { path: '/admin/brands', label: 'Brands', icon: Building2, testId: 'nav-brands' },
  { path: '/admin/agents', label: 'Agents', icon: Bot, testId: 'nav-agents' },
  { path: '/admin/users', label: 'Users', icon: UsersIcon, testId: 'nav-users' },
  { path: '/admin/assignments', label: 'Assignments', icon: LinkIcon, testId: 'nav-assignments' }
];

const AgentsPage = () => {
  const [agents, setAgents] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [formData, setFormData] = useState({ name: '', description: '', useBasicColumns: true });

  useEffect(() => {
    fetchAgents();
  }, []);

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

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6" data-testid="agents-page">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Agents</h1>
            <p className="text-slate-600 mt-1">Manage processing agents for data automation</p>
          </div>
          <Button onClick={() => setShowModal(true)} data-testid="create-agent-button">
            <Plus className="mr-2 h-4 w-4" />
            Create Agent
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>All Agents</CardTitle>
            <CardDescription>Available processing agents in the system</CardDescription>
          </CardHeader>
          <CardContent>
            {agents.length === 0 ? (
              <div className="py-8 text-center text-slate-600">
                <Bot className="h-12 w-12 text-slate-400 mx-auto mb-4" />
                No agents created yet
              </div>
            ) : (
              <div className="border border-slate-200 rounded-lg">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {agents.map((agent) => (
                      <TableRow key={agent.id} data-testid={`agent-row-${agent.id}`}>
                        <TableCell className="font-medium">{agent.name}</TableCell>
                        <TableCell className="max-w-xs">{agent.description || 'N/A'}</TableCell>
                        <TableCell className="text-sm">
                          {agent.createdAt ? format(new Date(agent.createdAt), 'dd MMM yyyy') : 'N/A'}
                        </TableCell>
                        <TableCell>
                          <Badge variant="success">Active</Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
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
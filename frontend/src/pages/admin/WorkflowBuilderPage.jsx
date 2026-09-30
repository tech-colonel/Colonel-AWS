import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { ArrowLeft, GitBranch, Loader2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import api from '../../lib/api';
import { toast } from 'sonner';
import { ADMIN_SIDEBAR } from '../../lib/adminNav';
import WorkflowManagerModal from './WorkflowManagerModal';

// Full-page Workflow Builder — replaces the old cramped modal so the sheet /
// column editor has real room to breathe. Reuses WorkflowManagerModal's
// `inline` render mode (list + build views, no Dialog chrome) inside this
// page's own header/back-button shell.
const WorkflowBuilderPage = () => {
  const { agentId } = useParams();
  const [searchParams] = useSearchParams();
  const editWorkflowId = searchParams.get('edit');
  const navigate = useNavigate();

  const [agent,   setAgent]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [initialEditWorkflow, setInitialEditWorkflow] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const { data: agents } = await api.get('/api/agents');
        const found = agents.find(a => a.id === agentId);
        if (cancelled) return;
        if (!found) {
          toast.error('Agent not found');
          setAgent(null);
        } else {
          setAgent(found);
          if (editWorkflowId) {
            const { data: workflows } = await api.get(`/api/agents/${agentId}/workflows`);
            if (cancelled) return;
            const wf = workflows.find(w => w.id === editWorkflowId);
            if (wf) setInitialEditWorkflow(wf);
          }
        }
      } catch {
        if (!cancelled) toast.error('Failed to load agent');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, editWorkflowId]);

  const goBack = () => navigate('/admin/agents');

  return (
    <DashboardLayout sidebarItems={ADMIN_SIDEBAR}>
      <div className="p-6 max-w-[1400px] mx-auto">
        <Button variant="ghost" onClick={goBack} className="mb-4 -ml-4">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Agents
        </Button>

        {loading ? (
          <div className="py-24 flex items-center justify-center text-slate-400">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
          </div>
        ) : !agent ? (
          <div className="py-24 text-center text-slate-400">
            <GitBranch className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-sm">Agent not found.</p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-6">
              <GitBranch className="h-6 w-6 text-indigo-600" />
              <div>
                <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Workflow Builder</h1>
                <p className="text-slate-500 text-sm">{agent.name}</p>
              </div>
            </div>

            <WorkflowManagerModal
              agent={agent}
              open={true}
              inline={true}
              initialEditWorkflow={initialEditWorkflow}
              onClose={goBack}
            />
          </>
        )}
      </div>
    </DashboardLayout>
  );
};

export default WorkflowBuilderPage;

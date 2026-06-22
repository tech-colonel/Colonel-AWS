import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import DashboardLayout from '../../components/layout/DashboardLayout';
import { Building2, Workflow, Plus, Trash2, Share2, Clock } from 'lucide-react';
import { Button } from '../../components/ui/button';
import api from '../../lib/api';
import { toast } from 'sonner';
import { sidebarFor, isAdminUser } from '../../lib/adminNav';

const fmt = (s) => { try { return new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

const PlansPage = () => {
  const navigate = useNavigate();
  const admin = isAdminUser();
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);

  const sidebarItems = sidebarFor([
    { path: '/brands', label: 'Brands', icon: Building2 },
    { path: '/plans', label: 'Plans', icon: Workflow },
  ]);

  useEffect(() => { fetchPlans(); }, []);

  const fetchPlans = async () => {
    try { const r = await api.get('/api/plans'); setPlans(r.data); }
    catch { toast.error('Failed to load plans'); }
    finally { setLoading(false); }
  };

  const newPlan = async () => {
    const name = window.prompt('Plan name?');
    if (!name?.trim()) return;
    try {
      const r = await api.post('/api/plans', { name: name.trim() });
      navigate(`/admin/plans/${r.data.id}`);
    } catch { toast.error('Could not create plan'); }
  };

  const remove = async (e, id) => {
    e.stopPropagation();
    if (!window.confirm('Delete this plan?')) return;
    try { await api.delete(`/api/plans/${id}`); setPlans(p => p.filter(x => x.id !== id)); toast.success('Deleted'); }
    catch { toast.error('Could not delete'); }
  };

  const openPlan = (id) => navigate(admin ? `/admin/plans/${id}` : `/plans/${id}`);

  return (
    <DashboardLayout sidebarItems={sidebarItems}>
      <div className="p-6" data-testid="plans-page">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Plans</h1>
            <p className="text-slate-600 mt-1">{admin ? 'Build visual plans and share them with your team' : 'Plans shared with you'}</p>
          </div>
          {admin && <Button onClick={newPlan}><Plus className="mr-2 h-4 w-4" />New Plan</Button>}
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">{[1,2,3].map(i => <div key={i} className="h-32 rounded-2xl bg-slate-100 animate-pulse" />)}</div>
        ) : plans.length === 0 ? (
          <div className="rounded-2xl border bg-white p-12 text-center" style={{ borderColor: '#E2E8F0' }}>
            <Workflow className="h-12 w-12 text-slate-300 mx-auto mb-3" />
            <p className="text-sm text-slate-500">{admin ? 'No plans yet — create your first visual plan.' : 'No plans shared with you yet.'}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {plans.map(p => (
              <button key={p.id} onClick={() => openPlan(p.id)}
                className="text-left rounded-2xl border bg-white p-5 transition-shadow hover:shadow-md group" style={{ borderColor: '#E2E8F0' }}>
                <div className="flex items-start justify-between mb-2">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-indigo-50 border border-indigo-200">
                    <Workflow className="w-5 h-5 text-indigo-600" />
                  </div>
                  {admin && (
                    <button onClick={(e) => remove(e, p.id)} className="text-slate-300 hover:text-rose-500 transition-colors"><Trash2 className="w-4 h-4" /></button>
                  )}
                </div>
                <h3 className="text-sm font-bold text-slate-900 mb-1">{p.name}</h3>
                {p.description && <p className="text-xs text-slate-500 mb-3 line-clamp-2">{p.description}</p>}
                <div className="flex items-center gap-3 text-xs text-slate-400 mt-2">
                  <span>{p.nodeCount} nodes</span>
                  {(p.shared_with?.length > 0) && <span className="flex items-center gap-1"><Share2 className="w-3 h-3" />{p.shared_with.length} shared</span>}
                  <span className="flex items-center gap-1 ml-auto"><Clock className="w-3 h-3" />{fmt(p.updatedAt)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
};

export default PlansPage;
